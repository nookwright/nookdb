# @nookdb/react

React hook for reactive [`nookdb`](https://www.npmjs.com/package/nookdb) queries.

## Install

```
npm install @nookdb/react nookdb react
```

Peer deps: `nookdb ^1.0.0`, `react ^18 || ^19`.

## useLive

```tsx
import { useLive } from '@nookdb/react';

function AdminList({ db }) {
  const admins = useLive(() => db.users.live({ role: 'admin' }), [db]);
  return <ul>{admins.map(u => <li key={u.id}>{u.email}</li>)}</ul>;
}
```

The hook re-renders whenever a committed write touches a matching document. See https://nookdb.pages.dev/reference/react.

## License

MIT
