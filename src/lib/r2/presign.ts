import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Client, R2_BUCKET } from "./client";

export async function presignFirmwareUrl(
  objectKey: string,
  expiresInSeconds = 3600
): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
  return getSignedUrl(getR2Client(), cmd, { expiresIn: expiresInSeconds });
}
