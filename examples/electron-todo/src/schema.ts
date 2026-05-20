import { s } from 'nookdb';

export const schema = {
  todos: s
    .collection({
      id: s.id(),
      // s.string() has no .min/.max on the M2 surface; length validation
      // is deferred to the Rust core (authoritative validator, PRD §3).
      title: s.string(),
      done: s.boolean().default(false),
      createdAt: s.date().default(() => new Date()),
    })
    .index('done'),
};
