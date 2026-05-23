export interface CommitEntry {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  author: string;
}

export async function getLatestCommits(): Promise<CommitEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(
      'https://api.github.com/repos/nookwright/nookdb/commits?per_page=3',
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
        },
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!res.ok) {
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await res.json();

    return data.map((item) => ({
      sha: item.sha as string,
      shortSha: (item.sha as string).slice(0, 7),
      message: (item.commit.message as string).split('\n')[0],
      date: item.commit.author.date as string,
      author: item.commit.author.name as string,
    }));
  } catch {
    clearTimeout(timeout);
    return [];
  }
}
