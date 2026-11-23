// AI provider presets for the "Add provider" picker (AI tab).
// protocol picks the request format in main.js: 'openai' → {baseUrl}/chat/completions,
// 'anthropic' → {baseUrl}/v1/messages. brand = BRAND_PATHS key, icon = ICON_PATHS key
// (custom entries). nameKey → i18n.js for names that are translated.
// vision:false marks APIs that reject image input; hintKey adds a setup note in the editor.
const PROVIDER_PRESETS = [
    { id: 'openai', name: 'OpenAI', brand: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', keyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'anthropic', name: 'Anthropic', brand: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
    { id: 'gemini', name: 'Gemini', brand: 'gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
    { id: 'deepseek', name: 'DeepSeek', brand: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys', vision: false },
    { id: 'qwen', nameKey: 'pvQwen', brand: 'qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1' },
    { id: 'kimi', name: 'Kimi', brand: 'kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
    { id: 'zhipu', nameKey: 'pvZhipu', brand: 'zhipu', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5v', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
    { id: 'siliconflow', nameKey: 'pvSiliconflow', brand: 'siliconflow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-72B-Instruct', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
    { id: 'openrouter', name: 'OpenRouter', brand: 'openrouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o', keyUrl: 'https://openrouter.ai/keys' },
    { id: 'ollama', nameKey: 'pvOllama', brand: 'ollama', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: '', noKey: true, hintKey: 'provOllamaHint' },
    { id: 'custom-openai', nameKey: 'pvCustomOpenai', icon: 'cpu', protocol: 'openai', baseUrl: '', model: '' },
    { id: 'custom-anthropic', nameKey: 'pvCustomAnthropic', icon: 'cpu', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '' }
];

// Shown when an Anthropic-protocol endpoint has no /v1/models (e.g. some relays)
const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'];

const presetById = (id) => PROVIDER_PRESETS.find(p => p.id === id);
// Preset for a saved provider entry; unknown ids fall back to the custom entry of the same protocol
const presetOf = (entry) => presetById(entry.preset) || presetById(entry.protocol === 'anthropic' ? 'custom-anthropic' : 'custom-openai');

export { PROVIDER_PRESETS, ANTHROPIC_MODELS, presetById, presetOf };
