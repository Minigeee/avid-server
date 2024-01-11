import assert from 'assert';

import _config from '../config';

import { S3 } from '@aws-sdk/client-s3';
import multer, { Options } from 'multer';
import multerS3 from 'multer-s3';

// Adds env
function _key(key: string) {
  return process.env.NODE_ENV + '/' + key;
}

assert(process.env.DIGITAL_OCEAN_SPACES_ACCESS_KEY);
assert(process.env.DIGITAL_OCEAN_SPACES_SECRET);

/** S3 client */
const s3client = new S3({
  forcePathStyle: false, // Configures to use subdomain/virtual calling format.
  endpoint: _config.spaces.endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.DIGITAL_OCEAN_SPACES_ACCESS_KEY,
    secretAccessKey: process.env.DIGITAL_OCEAN_SPACES_SECRET,
  },
});

/**
 * Create a file upload middleware using multer
 *
 * @param key A function that generates a file key (location) to store the incoming data
 * @param options The file limits options
 * @returns A multer middleware object
 */
export function upload(
  key: (req: Express.Request, file: Express.Multer.File) => string,
  options?: Options['limits'],
) {
  return multer({
    storage: multerS3({
      s3: s3client,
      bucket: _config.spaces.bucket,
      acl: 'public-read',
      key: (req, file, cb) => {
        try {
          cb(null, _key(key(req, file)));
        } catch (err) {
          cb(err, undefined);
        }
      },
      contentType: (req, file, cb) => {
        let type = 'application/octet-stream';
        // Make images the correct type
        if (file.mimetype.startsWith('image')) type = file.mimetype;

        cb(null, type);
      },
    }),
    limits: options,
  });
}

export const s3 = {
  /** The s3 client */
  client: s3client,

  /**
   * Delete a resource
   *
   * @param key The key of the resource to delete
   * @returns The output promise
   */
  delete: (key: string) =>
    s3client.deleteObject({
      Bucket: _config.spaces.bucket,
      Key: _key(key),
    }),

  /**
   * Get a resource
   *
   * @param key The key of the resource to retrieve
   * @returns The output promise
   */
  get: (key: string) =>
    s3client.getObject({
      Bucket: _config.spaces.bucket,
      Key: _key(key),
    }),
};


/** Spaces config */
export const config = {
  /** Spaces url endpoint */
  endpoint: `https://${_config.spaces.bucket}.${_config.spaces.endpoint
    .split('/')
    .at(-1)}`,
  /** Image path path */
  img_path: 'images/',
};

/**
 * Get a resource url from its key
 *
 * @param key The key of the resource
 * @returns The resource url string
 */
export function getResourceUrl(key: string) {
  return `${config.endpoint}/${process.env.NODE_ENV}/${key}`;
}

/**
 * Get a resource key from its url
 *
 * @param url The url of the resource
 * @returns The resource key
 */
export function getResourceKey(url: string) {
  // Resource needs to start with string
  assert(url.startsWith(config.endpoint) && process.env.NODE_ENV);
  return url.substring(
    config.endpoint.length + process.env.NODE_ENV.length + 2,
  );
}

/**
 * Get a image url from its key. The url is the expected `src` value
 * assuming the image optimizer will be used.
 *
 * @param key The key of the image
 * @returns The image url string
 */
export function getImageUrl(key: string) {
  assert(key.startsWith(config.img_path));
  return key.substring(config.img_path.length);
}

/**
 * Get a image key from its url. The url is expected to be
 * in the form that the image optimizer uses.
 *
 * @param url The url of the image
 * @returns The image key
 */
export function getImageKey(url: string) {
  if (url.startsWith('/')) url = url.substring(1);
  return config.img_path + url;
}
