import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const browserDownloadPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj\n4 0 obj<</Length 0>>stream\n\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

export async function createBrowserDownloadFixture() {
  const cookie = randomUUID();
  let authenticated = 0;
  let unauthenticated = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/session') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': `synthetic-session=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
      });
      response.end(`<html><title>Synthetic invoices</title><body>
        <a id="download" href="/invoice.pdf" download="invoice.pdf">Download invoice</a>
        <button id="popup" onclick="window.open('/invoice.pdf','_blank')">Invoice popup</button>
        <button id="blob" onclick="fetch('/invoice.pdf').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=window.URL.createObjectURL(b);a.download='invoice.pdf';document.body.append(a);a.click()})">Invoice blob</button>
        <a id="blob-anchor" href="#" onclick="event.preventDefault();fetch('/invoice.pdf').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=window.URL.createObjectURL(b);a.download='invoice.pdf';document.body.append(a);a.click()})">Generate invoice</a>
        <a id="inline" href="/inline.pdf">View invoice</a>
        </body></html>`);
    } else if (url.pathname === '/invoice.pdf' || url.pathname === '/inline.pdf') {
      if (request.headers.cookie !== `synthetic-session=${cookie}`) {
        unauthenticated++;
        response.writeHead(403);
        response.end('Authentication required');
        return;
      }
      authenticated++;
      const bytes =
        url.searchParams.get('version') === 'current'
          ? Buffer.concat([browserDownloadPdf, Buffer.from('% current document\n')])
          : browserDownloadPdf;
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': bytes.length,
        'content-disposition': `${url.pathname === '/inline.pdf' ? 'inline' : 'attachment'}; filename="invoice.pdf"`,
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture could not start.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    authenticatedDownloads: () => authenticated,
    unauthenticatedDownloads: () => unauthenticated,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
