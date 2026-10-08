# ImapKit documentation

The Docusaurus site published at [imapkit.com](https://imapkit.com/). The pages are in `docs/`, the homepage in `src/pages/index.tsx`.

```bash
npm install
npm start          # dev server with hot reload
npm run build      # static site in build/, broken links fail the build
npm run typecheck
```

`.github/workflows/docs.yml` in the repository root builds the site for pull requests that change `docs/` and deploys it to GitHub Pages from master. There is no manual deploy.
