// The old Cloudflare Pages address. The app and its server now live on the Velcord machine, so the app
// pages and API calls are sent there. Plain files (install script, desktop app downloads) are still served here.
const HOME = 'https://velcord.scrisoricupovesti.ro';

export default {
  async fetch(request: Request, env: { ASSETS: { fetch(r: Request): Promise<Response> } }): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const isApp = url.pathname === '/' || url.pathname === '/app' || url.pathname.startsWith('/app/');
    if (isApi || isApp) return Response.redirect(HOME + url.pathname + url.search, isApi ? 307 : 302);
    return env.ASSETS.fetch(request);
  },
};
