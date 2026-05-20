import { s } from 'nookdb';

export const schema = {
  notes: s
    .collection({
      id: s.id(),
      title: s.string(),
      body: s.string().default(''),
      tags: s.array(s.string()).default(() => []),
      updatedAt: s.date().default(() => new Date()),
    })
    .index('updatedAt'),
};
