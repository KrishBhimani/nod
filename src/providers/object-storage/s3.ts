import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ObjectStoreConflict, type PrivateObjectStore } from '../../ports/object-storage.ts';
import {
  maxObjectBytes,
  objectFailure,
  objectKey,
  objectLimit,
  objectVersion,
  readObjectBody,
} from './validation.ts';

export function createS3ObjectStore(options: {
  client: S3Client;
  bucket: string;
  ownerId: string;
  environment: string;
  timeoutMs?: number;
}): PrivateObjectStore {
  if (
    !options.bucket ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(options.environment) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(options.ownerId)
  )
    throw new Error('The private storage configuration is invalid.');
  const key = (value: string) => `${options.environment}/${options.ownerId}/${objectKey(value)}`;
  const signal = () => ({ abortSignal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  function failure(error: unknown): never {
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412)
      throw new ObjectStoreConflict();
    throw objectFailure();
  }
  return {
    async read(value, maximum) {
      objectLimit(maximum);
      try {
        const response = await options.client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key(value) }),
          signal(),
        );
        if (
          !response.Body ||
          !response.ETag ||
          (response.ContentLength !== undefined && response.ContentLength > maximum)
        ) {
          await response.Body?.transformToWebStream().cancel();
          throw objectFailure();
        }
        return {
          bytes: await readObjectBody(
            response.Body.transformToWebStream(),
            maximum,
            options.timeoutMs,
          ),
          version: objectVersion(response.ETag),
        };
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404
        )
          return undefined;
        return failure(error);
      }
    },
    async write(value, bytes, { expectedVersion }) {
      if (bytes.byteLength > maxObjectBytes) throw objectFailure();
      try {
        const response = await options.client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key(value),
            Body: bytes,
            ContentType: 'application/octet-stream',
            ...(expectedVersion === null
              ? { IfNoneMatch: '*' }
              : { IfMatch: objectVersion(expectedVersion) }),
          }),
          signal(),
        );
        if (!response.ETag) throw objectFailure();
        return objectVersion(response.ETag);
      } catch (error) {
        return failure(error);
      }
    },
    async remove(value, condition) {
      try {
        await options.client.send(
          new DeleteObjectCommand({
            Bucket: options.bucket,
            Key: key(value),
            ...(condition?.expectedVersion !== undefined
              ? { IfMatch: objectVersion(condition.expectedVersion) }
              : {}),
          }),
          signal(),
        );
      } catch (error) {
        failure(error);
      }
    },
  };
}
