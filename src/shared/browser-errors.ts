const browserErrors = {
  browser_navigation_failed:
    'The website did not load successfully. Open another public page or retry navigation later; taking screenshots cannot recover a failed page.',
} as const;

export type BrowserErrorCode = keyof typeof browserErrors;

export function browserErrorMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(browserErrors, code)
    ? browserErrors[code as BrowserErrorCode]
    : undefined;
}
