import './globals.css';
export const metadata = { title: 'Document Duplicator', description: 'Private document utility', robots: { index: false, follow: false, noarchive: true } };
export const viewport = { width: 'device-width', initialScale: 1 };
export default function L({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
