import { HomeLayoutClient } from './layout-client';

export default function HomeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <HomeLayoutClient>{children}</HomeLayoutClient>;
}
