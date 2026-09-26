export interface AudioInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}
export interface GeneratedAudio {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface SpeechProvider {
  id: string;
  configured: boolean;
  transcribe(input: AudioInput, signal?: AbortSignal): Promise<string>;
  synthesize(text: string, signal?: AbortSignal): Promise<GeneratedAudio>;
}
