export interface PublicLinkMetadata {
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  image?: string;
}

export interface PreviewImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface LinkPreviewProvider {
  metadata(url: string): Promise<PublicLinkMetadata | null>;
  image(url: string): Promise<PreviewImage | null>;
}
