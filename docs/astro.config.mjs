import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://nookdb.pages.dev',
  integrations: [
    starlight({
      title: 'nookdb',
      description: 'Schema-first, reactive, local-first database for Electron.',
      logo: { src: './src/assets/logo.svg' },
      social: {
        github: 'https://github.com/nookwright/nookdb',
      },
      sidebar: [
        { label: 'Quick start', link: '/quick-start/' },
        {
          label: 'Guides',
          items: [
            { label: 'Schema DSL', link: '/guides/schema-dsl/' },
            { label: 'Queries', link: '/guides/queries/' },
            { label: 'Reactive: live()', link: '/guides/reactive-live/' },
            { label: 'Migrations', link: '/guides/migrations/' },
            { label: 'CLI', link: '/guides/cli/' },
            { label: 'Electron bridge', link: '/guides/electron-bridge/' },
            { label: 'Backup / restore', link: '/guides/backup-restore/' },
            { label: 'Migrating from sehawq.db v5', link: '/guides/migrating-from-sehawq-v5/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Errors', link: '/reference/errors/' },
            { label: 'API', link: '/reference/api/' },
            { label: '.nbkp format', link: '/reference/nbkp-format/' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', link: '/architecture/overview/' },
          ],
        },
        {
          label: 'Compare',
          items: [
            { label: 'vs RxDB', link: '/compare/rxdb/' },
            { label: 'vs Jazz', link: '/compare/jazz/' },
            { label: 'vs Dexie', link: '/compare/dexie/' },
            { label: 'vs better-sqlite3', link: '/compare/better-sqlite3/' },
          ],
        },
      ],
      customCss: ['./src/styles/starlight-overrides.css'],
    }),
  ],
});
