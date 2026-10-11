import type { Metadata } from 'next';
import { Dashboard } from '@/components/Dashboard';

export const metadata: Metadata = { title: 'PICHIFI app · Agentic Yield Vault' };

export default function AppPage() {
  return <Dashboard />;
}
