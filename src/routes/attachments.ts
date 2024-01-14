import assert from 'assert';

import { Attachment, AttachmentType, ExpandedAttachment, FileAttachment, Reaction, Wiki, WithId } from '@app/types';
import { emitBatchEvent } from '../utility/batcher';
import {
  hasPermission,
  id,
  isMember,
  isPrivateMember,
  query,
  sql,
} from '../utility/query';
import { ApiRoutes } from '../utility/routes';
import {
  asBool,
  asRecord,
  isArray,
  isBool,
  isIn,
  isInt,
  isObject,
  isRecord,
  isString,
  sanitizeHtml,
} from '../utility/validate';
import { getChannel } from '../utility/db';
import { io } from '../sockets';
import { config as spacesConfig, getImageUrl, getResourceUrl, upload, getImageKey } from '../utility/spaces';
import config from '../config';

import bodyParser from 'body-parser';

// WIP : Make routes
const routes: ApiRoutes<`${string} /attachments${string}`> = {
  'POST /attachments/:container_id': {
    validate: {
      container_id: {
        required: true,
        location: 'params',
        transform: (value, req) =>
          typeof req.query.private === 'string' && req.query.private === 'true'
            ? asRecord('private_channels', value)
            : asRecord('domains', value),
      },
      private: {
        required: false,
        location: 'query',
        transform: asBool,
      },
      files: null,
      attachments: null,
    },
    permissions: (req) =>
      sql.return(
        req.query.private
          ? isPrivateMember(req.token.profile_id, req.params.container_id)
          : isMember(req.token.profile_id, req.params.container_id),
      ),
    middleware: [
      {
        before: 'end',
        wrapper: false,
        handler: (req, res, next) =>
          upload(
            (_, file) => {
              const isImage = file.mimetype.startsWith('image');

              // Generate key
              const prefix = isImage ? spacesConfig.img_path : '';
              const container_id = (req.query.private ? 'dm_' : '') + id(req.params.container_id);
              const profile_id = req.token.profile_id;
              const key = `${prefix}attachments/${container_id}/${id(
                profile_id,
              )}/${file.originalname}`;

              // Add resource keys
              if (!req.keys) req.keys = [];
              req.keys.push(key);

              return key;
            },
            { fileSize: config.upload.attachment.max_size },
          ).array('files', config.upload.attachment.max_number)(req as any, res, next),
      },
      {
        before: 'end',
        handler: async (req, res) => {
          // Validator for attachments
          const json = JSON.parse(req.body.attachments as unknown as string);
          req.body.attachments = isArray(json, (value) =>
            isObject<Omit<FileAttachment, 'file'>>(value, {
              alt: {
                required: false,
                transform: isString,
              },
              height: {
                required: false,
                transform: (value) => isInt(value, { min: 0 }),
              },
              type: {
                required: true,
                transform: (value) =>
                  isIn<AttachmentType>(value, ['file', 'image']),
              },
              width: {
                required: false,
                transform: (value) => isInt(value, { min: 0 }),
              },
            }),
          );

          // Make sure same number of files and attachments
          if (req.files?.length !== req.body.attachments.length)
            throw new Error(
              '"form.files" and "form.attachments" must have the same number of elements',
            );
        },
      },
    ],
    code: async (req, res) => {
      // List of urls
      const urls = req.keys.map((k) =>
        encodeURI(
          k.startsWith(spacesConfig.img_path)
            ? getImageUrl(k)
            : getResourceUrl(k),
        ),
      );

      // Insert all values
      const results = await query<ExpandedAttachment[]>(
        sql.insert<Attachment>(
          'attachments',
          req.body.attachments.map((f, i) => ({
            ...f,
            url: urls[i],
            filename: urls[i].split('/').at(-1),
          })),
          {
            on_conflict: {
              alt: sql.$('$input.alt'),
              height: sql.$('$input.height'),
              width: sql.$('$input.width'),
            },
          },
        ),
        { log: req.log },
      );
      assert(results);

      return results.map((f) => ({
        ...f,
        base_url:
          f.type === 'image' ? getResourceUrl(getImageKey(f.url)) : undefined,
      }));
    },
  },
};

export default routes;
