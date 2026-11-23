export class WebError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'FETCH_FAILED' | 'NOT_TEXT' | 'SEARCH_FAILED',
  ) {
    super(message);
  }
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}
