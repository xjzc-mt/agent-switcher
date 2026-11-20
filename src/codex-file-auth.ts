import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

function config(dir: string, file: string) {
  try { return parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Local Windows startup layers. The isolated app-server has its own home
 * and file override; system requirements and managed defaults still apply. */
export function windowsCodexFileIssue(home: string, isolated = false): string | undefined {
  // The built-in stored-login loader reads CODEX_API_KEY, not the general SDK OPENAI_API_KEY.
  if (!isolated && (process.env.OPENAI_FEDERATION_RULE_ID !== undefined || process.env.OPENAI_IDENTITY_TOKEN_FILE !== undefined ||
      process.env.CODEX_ACCESS_TOKEN?.trim() || process.env.CODEX_API_KEY?.trim())) {
    return 'Codex 检测到环境变量认证，无法用本地文件确认或切换当前账号';
  }
  const system = path.join(process.env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex');
  try {
    const requirements = config(system, 'requirements.toml');
    const base = { ...config(system, 'config.toml'), ...(isolated ? {} : config(home, 'config.toml')) };
    const name = base.profile;
    let profile = {};
    if (name && !isolated) {
      if (typeof name !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(name)) return '无法识别 Codex 配置档案名称，请核对登录配置';
      const legacy = base.profiles;
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy) && name in legacy) {
        const layer = (legacy as Record<string, unknown>)[name];
        if (layer && typeof layer === 'object') profile = layer;
      }
      profile = { ...profile, ...config(home, name + '.config.toml') };
    }
    const settings: Record<string, unknown> = { ...base, ...profile,
      ...(isolated ? { cli_auth_credentials_store: 'file' } : {}), ...config(home, 'managed_config.toml') };
    if (requirements.allowed_login_methods !== undefined || requirements.allowed_chatgpt_workspaces !== undefined ||
        settings.forced_login_method !== undefined || settings.forced_chatgpt_workspace_id !== undefined) {
      return 'Codex 配置限制了登录方式或工作区，请在官方客户端管理账号';
    }
    const service = requirements.chatgpt_base_url ?? settings.chatgpt_base_url;
    if (service !== undefined && service !== 'https://chatgpt.com/backend-api' && service !== 'https://chatgpt.com/backend-api/') {
      return 'Codex 使用自定义 ChatGPT 服务，AGS 无法核实该登录';
    }
    if (settings.model_provider && settings.model_provider !== 'openai') {
      return 'Codex 使用自定义模型服务，AGS 无法确认当前登录方式';
    }
    const store = requirements.cli_auth_credentials_store ?? settings.cli_auth_credentials_store ?? 'file';
    if (store !== 'file') return 'Codex 当前未使用可确认的文件凭据存储，请在官方客户端管理当前登录';
  } catch { return '无法读取 Codex 登录配置，请检查 TOML 文件和读取权限后重试'; }
}
