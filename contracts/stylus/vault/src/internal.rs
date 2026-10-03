//! Non-public vault logic: intent checks, rebalancing, liquidity sourcing, share
//! bookkeeping and the thin wrappers around external calls.

use super::*;

impl AgenticVault {
    // ------------------------------------------------------------------ intents

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build_intent(
        &self,
        nonce: u64,
        deadline: u64,
        regime: u8,
        morpho_bps: u16,
        uniswap_bps: u16,
        vol_bps: u16,
        inputs_hash: B256,
        model_version: B256,
    ) -> RebalanceIntent {
        RebalanceIntent {
            vault: self.vm().contract_address(),
            nonce,
            deadline,
            regime,
            morpho_bps,
            uniswap_bps,
            vol_bps,
            inputs_hash,
            model_version,
        }
    }

    /// Nonce, deadline, rate limit and guardrails — everything checkable before any call.
    pub(crate) fn check_intent(&self, intent: &RebalanceIntent) -> Result<(), VaultError> {
        let expected = self.nonce.get().to::<u64>();
        if intent.nonce != expected {
            return Err(VaultError::InvalidNonce(InvalidNonce { expected, got: intent.nonce }));
        }
        let now = self.vm().block_timestamp();
        if now > intent.deadline {
            return Err(VaultError::IntentExpired(IntentExpired { deadline: intent.deadline, nowTs: now }));
        }
        let last = self.last_rebalance.get().to::<u64>();
        let next_allowed = last.saturating_add(self.min_rebalance_interval.get().to::<u64>());
        if last != 0 && now < next_allowed {
            return Err(VaultError::RebalanceTooSoon(RebalanceTooSoon { nextAllowed: next_allowed }));
        }
        validate_allocation(
            intent.regime,
            intent.morpho_bps,
            intent.uniswap_bps,
            self.max_uniswap_bps.get().to::<u16>(),
        )?;
        if intent.uniswap_bps > 0 && self.adapter.get().is_zero() {
            return Err(VaultError::AdapterNotSet(AdapterNotSet {}));
        }
        Ok(())
    }

    pub(crate) fn check_signature(&self, digest: B256, signature: Bytes) -> Result<(), VaultError> {
        let data = IIntentVerifier::verifyCall { digest, signature }.abi_encode();
        let out = self.call_view(self.verifier.get(), data)?;
        let valid = IIntentVerifier::verifyCall::abi_decode_returns(&out).unwrap_or(false);
        if !valid {
            return Err(VaultError::InvalidSignature(InvalidSignature {}));
        }
        Ok(())
    }

    // ------------------------------------------------------------------ rebalancing

    /// Moves the vault to the target split. Phase 1 unwinds the LP leg (real proceeds are
    /// only known afterwards); phase 2 sizes Morpho and LP moves from actual balances.
    pub(crate) fn rebalance(&mut self, morpho_bps: u16, uniswap_bps: u16) -> Result<(), VaultError> {
        self.morpho_accrue()?;
        let before = self.holdings()?;
        let min_move = self.min_move.get();

        let unwind_bps = math::plan_unwind_bps(before, uniswap_bps, min_move);
        if unwind_bps > 0 {
            self.adapter_unwind(unwind_bps)?;
        }

        let mid = self.holdings()?;
        let moves = math::plan_moves(mid, morpho_bps, uniswap_bps, min_move);
        if moves.morpho_withdraw_all {
            self.morpho_withdraw_all()?;
        } else if !moves.morpho_withdraw.is_zero() {
            self.morpho_withdraw(moves.morpho_withdraw)?;
        }
        if !moves.uniswap_deploy.is_zero() {
            self.adapter_deploy(moves.uniswap_deploy)?;
        }
        if !moves.morpho_supply.is_zero() {
            self.morpho_supply(moves.morpho_supply)?;
        }

        let after = self.holdings()?;
        let (nav_before, nav_after) = (before.total(), after.total());
        let max_loss = self.max_nav_loss_bps.get().to::<u16>();
        if !math::nav_within_tolerance(nav_before, nav_after, max_loss) {
            return Err(VaultError::NavLossExceeded(NavLossExceeded {
                navBefore: nav_before,
                navAfter: nav_after,
            }));
        }
        self.vm().log(Rebalanced {
            idle: after.idle,
            morpho: after.morpho,
            uniswap: after.uniswap,
            navBefore: nav_before,
            navAfter: nav_after,
        });
        Ok(())
    }

    /// Makes at least `assets` idle: Morpho first (cheapest), then the LP leg. Returns the
    /// amount payable: `assets`, or — when `allow_slippage` — the realized amount if unwinding
    /// the LP returned less than its oracle value but within the `max_nav_loss_bps` guardrail.
    pub(crate) fn ensure_liquidity(&mut self, assets: U256, allow_slippage: bool) -> Result<U256, VaultError> {
        let idle = self.idle_assets()?;
        if idle >= assets {
            return Ok(assets);
        }
        self.morpho_accrue()?;
        let shortfall = assets - idle;
        let in_morpho = self.morpho_assets()?;
        if !in_morpho.is_zero() {
            if in_morpho <= shortfall {
                self.morpho_withdraw_all()?;
            } else {
                self.morpho_withdraw(shortfall)?;
            }
        }
        let idle = self.idle_assets()?;
        if idle >= assets {
            return Ok(assets);
        }
        let in_lp = self.adapter_value()?;
        if !in_lp.is_zero() {
            self.adapter_unwind(math::unwind_bps_for_shortfall(assets - idle, in_lp))?;
        }
        let idle = self.idle_assets()?;
        if idle >= assets {
            return Ok(assets);
        }
        let max_loss = self.max_nav_loss_bps.get().to::<u16>();
        if allow_slippage && math::nav_within_tolerance(assets, idle, max_loss) {
            return Ok(idle);
        }
        Err(VaultError::InsufficientLiquidity(InsufficientLiquidity { have: idle, want: assets }))
    }

    pub(crate) fn holdings(&self) -> Result<Holdings, VaultError> {
        Ok(Holdings {
            idle: self.idle_assets()?,
            morpho: self.morpho_assets()?,
            uniswap: self.adapter_value()?,
        })
    }

    pub(crate) fn idle_assets(&self) -> Result<U256, VaultError> {
        let this = self.vm().contract_address();
        let out = self.call_view(self.asset.get(), IERC20::balanceOfCall { account: this }.abi_encode())?;
        IERC20::balanceOfCall::abi_decode_returns(&out).map_err(|_| self.call_failed(self.asset.get()))
    }

    // ------------------------------------------------------------------ Morpho Blue

    pub(crate) fn market_params(&self) -> MarketParams {
        MarketParams {
            loanToken: self.asset.get(),
            collateralToken: self.market_collateral.get(),
            oracle: self.market_oracle.get(),
            irm: self.market_irm.get(),
            lltv: self.market_lltv.get(),
        }
    }

    fn morpho_supply_shares(&self) -> Result<U256, VaultError> {
        let this = self.vm().contract_address();
        let data = IMorpho::positionCall { id: self.market_id.get(), user: this }.abi_encode();
        let out = self.call_view(self.morpho.get(), data)?;
        let position = IMorpho::positionCall::abi_decode_returns(&out).map_err(|_| self.call_failed(self.morpho.get()))?;
        Ok(position.supplyShares)
    }

    pub(crate) fn morpho_assets(&self) -> Result<U256, VaultError> {
        let shares = self.morpho_supply_shares()?;
        if shares.is_zero() {
            return Ok(U256::ZERO);
        }
        let data = IMorpho::marketCall { id: self.market_id.get() }.abi_encode();
        let out = self.call_view(self.morpho.get(), data)?;
        let market = IMorpho::marketCall::abi_decode_returns(&out).map_err(|_| self.call_failed(self.morpho.get()))?;
        Ok(math::morpho_shares_to_assets(
            shares,
            U256::from(market.totalSupplyAssets),
            U256::from(market.totalSupplyShares),
        ))
    }

    fn morpho_accrue(&mut self) -> Result<(), VaultError> {
        if self.morpho_supply_shares()?.is_zero() {
            return Ok(());
        }
        let data = IMorpho::accrueInterestCall { marketParams: self.market_params() }.abi_encode();
        self.call_mut(self.morpho.get(), data).map(|_| ())
    }

    fn morpho_supply(&mut self, assets: U256) -> Result<(), VaultError> {
        let morpho = self.morpho.get();
        self.erc20_approve(morpho, assets)?;
        let this = self.vm().contract_address();
        let data = IMorpho::supplyCall {
            marketParams: self.market_params(),
            assets,
            shares: U256::ZERO,
            onBehalf: this,
            data: Bytes::new(),
        }
        .abi_encode();
        self.call_mut(morpho, data).map(|_| ())
    }

    fn morpho_withdraw(&mut self, assets: U256) -> Result<(), VaultError> {
        self.morpho_withdraw_raw(assets, U256::ZERO)
    }

    /// Withdraws by shares so no dust is left behind.
    fn morpho_withdraw_all(&mut self) -> Result<(), VaultError> {
        let shares = self.morpho_supply_shares()?;
        if shares.is_zero() {
            return Ok(());
        }
        self.morpho_withdraw_raw(U256::ZERO, shares)
    }

    fn morpho_withdraw_raw(&mut self, assets: U256, shares: U256) -> Result<(), VaultError> {
        let this = self.vm().contract_address();
        let data = IMorpho::withdrawCall {
            marketParams: self.market_params(),
            assets,
            shares,
            onBehalf: this,
            receiver: this,
        }
        .abi_encode();
        self.call_mut(self.morpho.get(), data).map(|_| ())
    }

    // ------------------------------------------------------------------ Uniswap v4 adapter

    pub(crate) fn adapter_value(&self) -> Result<U256, VaultError> {
        let adapter = self.adapter.get();
        if adapter.is_zero() {
            return Ok(U256::ZERO);
        }
        let out = self.call_view(adapter, ILiquidityAdapter::totalValueCall {}.abi_encode())?;
        ILiquidityAdapter::totalValueCall::abi_decode_returns(&out).map_err(|_| self.call_failed(adapter))
    }

    fn adapter_deploy(&mut self, amount: U256) -> Result<(), VaultError> {
        let adapter = self.adapter.get();
        if adapter.is_zero() {
            return Err(VaultError::AdapterNotSet(AdapterNotSet {}));
        }
        self.erc20_approve(adapter, amount)?;
        self.call_mut(adapter, ILiquidityAdapter::deployCall { amount }.abi_encode()).map(|_| ())
    }

    fn adapter_unwind(&mut self, bps: u16) -> Result<(), VaultError> {
        let adapter = self.adapter.get();
        if adapter.is_zero() {
            return Ok(());
        }
        let data = ILiquidityAdapter::unwindCall { bps: U256::from(bps) }.abi_encode();
        self.call_mut(adapter, data).map(|_| ())
    }

    // ------------------------------------------------------------------ USDG (ERC-20)

    pub(crate) fn erc20_transfer_from(&mut self, from: Address, to: Address, amount: U256) -> Result<(), VaultError> {
        let asset = self.asset.get();
        let out = self.call_mut(asset, IERC20::transferFromCall { from, to, amount }.abi_encode())?;
        self.require_bool_success(asset, &out)
    }

    pub(crate) fn erc20_transfer(&mut self, to: Address, amount: U256) -> Result<(), VaultError> {
        let asset = self.asset.get();
        let out = self.call_mut(asset, IERC20::transferCall { to, amount }.abi_encode())?;
        self.require_bool_success(asset, &out)
    }

    fn erc20_approve(&mut self, spender: Address, amount: U256) -> Result<(), VaultError> {
        let asset = self.asset.get();
        let out = self.call_mut(asset, IERC20::approveCall { spender, amount }.abi_encode())?;
        self.require_bool_success(asset, &out)
    }

    /// SafeERC20 semantics: empty return data or `true`.
    fn require_bool_success(&self, token: Address, out: &[u8]) -> Result<(), VaultError> {
        if out.is_empty() || bool::abi_decode(out).unwrap_or(false) {
            return Ok(());
        }
        Err(self.call_failed(token))
    }

    // ------------------------------------------------------------------ external calls

    pub(crate) fn call_mut(&mut self, to: Address, data: Vec<u8>) -> Result<Vec<u8>, VaultError> {
        let ctx = Call::new_mutating(self);
        call_contract(self.vm(), ctx, to, &data).map_err(|_| self.call_failed(to))
    }

    pub(crate) fn call_view(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>, VaultError> {
        static_call(self.vm(), Call::new(), to, &data).map_err(|_| self.call_failed(to))
    }

    fn call_failed(&self, target: Address) -> VaultError {
        VaultError::ExternalCallFailed(ExternalCallFailed { target })
    }

    // ------------------------------------------------------------------ shares bookkeeping

    pub(crate) fn mint(&mut self, to: Address, shares: U256) {
        self.total_supply.set(self.total_supply.get() + shares);
        let balance = self.balances.get(to);
        self.balances.insert(to, balance + shares);
        self.vm().log(Transfer { from: Address::ZERO, to, value: shares });
    }

    pub(crate) fn burn(&mut self, from: Address, shares: U256) -> Result<(), VaultError> {
        let balance = self.balances.get(from);
        if balance < shares {
            return Err(VaultError::InsufficientBalance(InsufficientBalance { have: balance, want: shares }));
        }
        self.balances.insert(from, balance - shares);
        self.total_supply.set(self.total_supply.get() - shares);
        self.vm().log(Transfer { from, to: Address::ZERO, value: shares });
        Ok(())
    }

    pub(crate) fn move_shares(&mut self, from: Address, to: Address, value: U256) -> Result<(), VaultError> {
        if to.is_zero() {
            return Err(VaultError::ZeroAddress(ZeroAddress {}));
        }
        let from_balance = self.balances.get(from);
        if from_balance < value {
            return Err(VaultError::InsufficientBalance(InsufficientBalance { have: from_balance, want: value }));
        }
        self.balances.insert(from, from_balance - value);
        let to_balance = self.balances.get(to);
        self.balances.insert(to, to_balance + value);
        self.vm().log(Transfer { from, to, value });
        Ok(())
    }

    pub(crate) fn spend_allowance(&mut self, owner: Address, spender: Address, value: U256) -> Result<(), VaultError> {
        let current = self.allowances.getter(owner).get(spender);
        if current == U256::MAX {
            return Ok(());
        }
        if current < value {
            return Err(VaultError::InsufficientAllowance(InsufficientAllowance { have: current, want: value }));
        }
        self.allowances.setter(owner).insert(spender, current - value);
        Ok(())
    }

    // ------------------------------------------------------------------ access control

    pub(crate) fn only_owner(&self) -> Result<(), VaultError> {
        let caller = self.vm().msg_sender();
        if caller != self.owner.get() {
            return Err(VaultError::Unauthorized(Unauthorized { caller }));
        }
        Ok(())
    }

    pub(crate) fn only_guardian_or_owner(&self) -> Result<(), VaultError> {
        let caller = self.vm().msg_sender();
        if caller != self.owner.get() && caller != self.guardian.get() {
            return Err(VaultError::Unauthorized(Unauthorized { caller }));
        }
        Ok(())
    }

    pub(crate) fn when_not_paused(&self) -> Result<(), VaultError> {
        if self.paused.get() {
            return Err(VaultError::Paused(Paused {}));
        }
        Ok(())
    }
}
