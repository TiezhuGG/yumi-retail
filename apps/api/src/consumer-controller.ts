import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConsumerAuthService } from './consumer-auth.js';
import { Consumer, Public } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const userSchema = object({
  id: { type: 'string', format: 'uuid' },
  displayName: text,
  provider: { type: 'string', enum: ['DEVELOPMENT', 'WECHAT'] },
});
const expiresAt = { type: 'string' as const, format: 'date-time' };
function noFields(value: unknown) {
  if (
    value !== undefined &&
    (typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length)
  )
    throw failure(400, 'VALIDATION_ERROR', '此接口不接受额外字段');
}
@ApiTags('消费者会话')
@Controller('consumer')
export class ConsumerController {
  constructor(@Inject(ConsumerAuthService) private readonly auth: ConsumerAuthService) {}
  @Public()
  @Post('auth/dev-session')
  @HttpCode(200)
  @ApiHeader({ name: 'X-Yumi-Dev-Login', required: true, schema: { type: 'string', enum: ['1'] } })
  @ApiBody({ schema: object({ profile: { type: 'string', enum: ['customer-a', 'customer-b'] } }) })
  @ApiOperation({ summary: '显式开启的本机开发身份登录；不是微信登录' })
  @ApiResult(object({ token: text, expiresAt, user: userSchema }), [400, 401, 403, 404, 429, 500])
  async login(@Req() request: ApiRequest, @Body() body: unknown, @Query() query: unknown) {
    noFields(query);
    return success(request, await this.auth.login(request, body));
  }
  @Public()
  @Get('auth/methods')
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({
      wechatLoginEnabled: { type: 'boolean' },
      developmentLoginEnabled: { type: 'boolean' },
    }),
    [400],
  )
  methods(@Req() r: ApiRequest, @Query() q: unknown) {
    noFields(q);
    return success(r, {
      wechatLoginEnabled: !!this.auth.config.wechatLogin,
      developmentLoginEnabled: this.auth.developmentAllowed(r),
    });
  }
  @Public()
  @Post('auth/wechat-session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiBody({ schema: object({ code: { type: 'string', minLength: 1, maxLength: 128 } }) })
  @ApiResult(
    object({ token: text, expiresAt, user: userSchema }),
    [400, 401, 403, 404, 429, 500, 503],
  )
  async wechat(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    noFields(q);
    return success(r, await this.auth.wechatLogin(r, b));
  }
  @Consumer()
  @Get('me')
  @ApiBearerAuth('consumerSession')
  @ApiOperation({ summary: '仅返回当前消费者身份；不接受用户编号' })
  @ApiResult(object({ user: userSchema, expiresAt }), [400, 401, 500])
  me(@Req() request: ApiRequest, @Query() query: unknown) {
    noFields(query);
    const context = request.consumerContext!;
    return success(request, {
      user: { id: context.userId, displayName: context.displayName, provider: context.provider },
      expiresAt: context.expiresAt,
    });
  }
  @Consumer()
  @Post('auth/logout')
  @HttpCode(200)
  @ApiBearerAuth('consumerSession')
  @ApiOperation({ summary: '撤销当前消费者会话；不会清空游客草稿' })
  @ApiResult(object({ loggedOut: { type: 'boolean' } }), [400, 401, 500])
  async logout(@Req() request: ApiRequest, @Body() body: unknown, @Query() query: unknown) {
    noFields(body);
    noFields(query);
    await this.auth.logout(request, request.consumerContext!);
    return success(request, { loggedOut: true });
  }
}
