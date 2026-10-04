// The old Cloudflare Pages address keeps working for the website and the installed desktop app.
// The page files come from Pages. Everything under /api/ (pictures, GIFs, clips) is passed on to the Velcord machine;
// the app's own calls go straight to that machine (VITE_API_URL), so only these file requests count against Pages.
const BACKEND = 'https://velcord.scrisoricupovesti.ro';

export default {
  async fetch(request: Request, env: { ASSETS: { fetch(r: Request): Promise<Response> } }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return fetch(new Request(BACKEND + url.pathname + url.search, request));
    return env.ASSETS.fetch(request);
  },
};
