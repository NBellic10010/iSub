import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'iSub — non-custodial subscriptions on Sui',
  description: 'Recurring & metered pull-payments on Sui. Non-custodial. Cancel anytime. Charges settle on-chain.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
