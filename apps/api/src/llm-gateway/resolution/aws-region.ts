/**
 * An AWS region name: `us-east-1`, `eu-central-2`, `ap-southeast-4`,
 * `us-gov-west-1`, `il-central-1`. Lowercase letters, one to three dash
 * segments, then the region number. Nothing that can change a URL's host.
 *
 * Its own module on purpose: `descriptors.ts` is replaced wholesale by
 * `mock.module` in several test files, and a new export there would vanish
 * from every one of them.
 */
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+){1,2}-\d{1,2}$/;

export function isAwsRegion(value: string): boolean {
  return AWS_REGION_PATTERN.test(value);
}
