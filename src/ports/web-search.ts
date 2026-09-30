export interface WebSearch {
  (
    query: string,
    signal: AbortSignal,
  ): Promise<{
    source: string;
    answer?: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
}

export interface WebFetch {
  (
    url: string,
    signal: AbortSignal,
  ): Promise<{
    url: string;
    title: string;
    content: string;
  }>;
}
