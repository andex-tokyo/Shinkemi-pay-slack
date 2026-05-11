export interface SlackRequestBody {
  token?: string;
  team_id?: string;
  team_domain?: string;
  channel_id?: string;
  channel_name?: string;
  user_id?: string;
  user_name?: string;
  command?: string;
  text?: string;
  response_url?: string;
  trigger_id?: string;
}

export interface SlackResponse {
  response_type: 'in_channel' | 'ephemeral';
  text: string;
}

export interface Env {
  SPREADSHEET_ID: string;
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
  SLACK_SIGNING_SECRET?: string;
  CHATGPT_ACTION_API_KEY?: string;
}

export interface PaymentEntry {
  date: string;
  item: string;
  payer: string;
  splitBill: boolean;
  amount: number;
}

export interface ApiPaymentRequest {
  item?: unknown;
  amount?: unknown;
  payer?: unknown;
  splitBill?: unknown;
}
