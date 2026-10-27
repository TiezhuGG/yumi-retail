import { applyDecorators } from '@nestjs/common';
import { ApiOkResponse, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';

export const text: SchemaObject = { type: 'string' };
export const strings: SchemaObject = { type: 'array', items: text };
export function object(properties: Record<string, SchemaObject>): SchemaObject {
  return {
    type: 'object',
    required: Object.keys(properties),
    properties,
    additionalProperties: false,
  };
}
export const warehouseSchema = object({ id: text, code: text, name: text });
export const items = (schema: SchemaObject) => object({ items: { type: 'array', items: schema } });
export const staffProfileSchema = object({
  id: text,
  loginName: text,
  displayName: text,
  roles: strings,
  permissions: strings,
  warehouseIds: strings,
  csrfToken: text,
});
export function ApiResult(data: SchemaObject, errors: number[] = [401, 403, 500]) {
  return applyDecorators(
    ApiOkResponse({ schema: object({ data, requestId: { type: 'string', format: 'uuid' } }) }),
    ...errors.map((status) =>
      ApiResponse({
        status,
        description: '错误码和可读信息；requestId关联日志',
        schema: object({
          error: object({ code: text, message: text }),
          requestId: { type: 'string', format: 'uuid' },
        }),
      }),
    ),
  );
}
