import { Env, SlackRequestBody, SlackResponse } from './types';
import { SheetsService } from './sheets';
import { CommandHandler } from './commands';
import { verifySlackRequest } from './slack-verification';
import { ApiHandler, unauthorizedResponse } from './api';
import { OPENAPI_YAML } from './openapi';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/openapi.yaml' && request.method === 'GET') {
      return new Response(OPENAPI_YAML, {
        status: 200,
        headers: { 'Content-Type': 'application/yaml; charset=utf-8' }
      });
    }

    if (url.pathname.startsWith('/api/')) {
      const payer = ApiHandler.getAuthenticatedPayer(request, env);
      if (!payer) {
        return unauthorizedResponse();
      }

      const api = new ApiHandler(env, payer);
      return api.handle(request);
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Slackリクエストの検証（オプション）
      if (env.SLACK_SIGNING_SECRET) {
        const clonedRequest = request.clone();
        const isValid = await verifySlackRequest(clonedRequest, env.SLACK_SIGNING_SECRET);
        if (!isValid) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      const formData = await request.formData();
      const body: SlackRequestBody = {};
      
      for (const [key, value] of formData.entries()) {
        body[key as keyof SlackRequestBody] = value as string;
      }


      // 非同期で処理を実行し、response_urlに結果を送信
      if (body.response_url) {
        ctx.waitUntil(
          this.processCommandAsync(body, env).catch(error => {
          })
        );
      }

      // Slackにすぐに200 OKを返す
      return new Response('', { status: 200 });
    } catch (error) {
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async processCommandAsync(body: SlackRequestBody, env: Env): Promise<void> {
    try {
      const response = await this.handleCommand(body, env);
      const result = await fetch(body.response_url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response)
      });
      
      if (!result.ok) {
      } else {
      }
    } catch (error) {
      
      try {
        await fetch(body.response_url!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `コマンドの処理中にエラーが発生しました: ${error}`
          })
        });
      } catch (sendError) {
      }
    }
  },

  async handleCommand(body: SlackRequestBody, env: Env): Promise<SlackResponse> {
    const sheets = new SheetsService(env.SPREADSHEET_ID, env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const handler = new CommandHandler(sheets);

    const command = body.command;
    const text = body.text || '';
    const userId = body.user_id || '';

    switch (command) {
      case '/pay':
        return handler.handlePay(text, true, userId);
      case '/pay_tatekae':
        return handler.handlePay(text, false, userId);
      case '/pay_list':
        return handler.handlePayList();
      case '/pay_delete':
        return handler.handlePayDelete(text);
      case '/pay_amount':
        return handler.handlePayAmount();
      default:
        return {
          response_type: 'ephemeral',
          text: 'Unknown command'
        };
    }
  }
};
