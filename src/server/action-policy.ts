type Intent = 'send' | 'draft' | 'create' | 'update' | 'schedule' | 'remember';

const ordinaryActions: Record<string, Intent[]> = {
  GMAIL_SEND_EMAIL: ['send'],
  GMAIL_REPLY_TO_THREAD: ['send'],
  GMAIL_CREATE_EMAIL_DRAFT: ['draft'],
  GMAIL_CREATE_DRAFT: ['draft'],
  SLACK_SEND_MESSAGE: ['send'],
  SLACK_POST_MESSAGE: ['send'],
  SLACK_OPEN_DM: ['send', 'draft'],
  SLACK_OPEN_CONVERSATION: ['send', 'draft'],
  SLACK_OPEN_AN_EXISTING_CONVERSATION: ['send', 'draft'],
  GOOGLECALENDAR_CREATE_EVENT: ['create', 'schedule'],
  GOOGLECALENDAR_UPDATE_EVENT: ['update', 'schedule'],
  GOOGLEDOCS_CREATE_DOCUMENT: ['create', 'draft'],
  GOOGLEDOCS_INSERT_TEXT: ['create', 'draft', 'update'],
  GOOGLESHEETS_CREATE_GOOGLE_SHEET1: ['create'],
  GOOGLESHEETS_UPDATE_SHEET: ['update'],
  NOTION_CREATE_NOTION_PAGE: ['create', 'draft'],
  NOTION_CREATE_A_PAGE: ['create', 'draft'],
  NOTION_APPEND_BLOCK_CHILDREN: ['create', 'draft', 'update'],
  SIDEKICK_profile_update: ['update', 'remember'],
  SIDEKICK_notification_preferences_update: ['update', 'remember'],
  SIDEKICK_memory_propose: ['remember'],
};

export function isReversiblePlanAction(action: string) {
  return [
    'SIDEKICK_goal_create',
    'SIDEKICK_goal_update',
    'SIDEKICK_schedule_create',
    'SIDEKICK_schedule_update',
    'SIDEKICK_schedule_cancel',
  ].includes(action);
}

const intentWords: Record<Intent, RegExp> = {
  send: /^(?:send|post|reply|email|message|forward|envia|enviar|manda|responde|publica)\b/i,
  draft: /^(?:draft|compose|write|prepare|rascunha|prepara|escreve)\b/i,
  create: /^(?:create|make|add|write|build|cria|criar|adiciona|faz|escreve)\b/i,
  update:
    /^(?:update|change|edit|rename|move|reschedule|pause|cancel\s+(?:the\s+)?(?:reminder|schedule)|atualiza|altera|edita|renomeia|muda|pausa|cancela\s+(?:o\s+)?lembrete)\b/i,
  schedule:
    /^(?:schedule|remind\s+me|set\s+(?:up\s+)?(?:a\s+)?reminder|agenda|lembra-me|lembre-me)\b/i,
  remember: /^(?:remember|save\s+(?:my|this)|learn|memoriza|lembra-te|guarda)\b/i,
};

const actionScopes: Record<string, RegExp> = {
  GMAIL: /\b(?:e-?mail|gmail|inbox|thread|email draft)\b/i,
  SLACK: /\b(?:slack|direct message|dm)\b/i,
  GOOGLECALENDAR: /\b(?:calendar|event|meeting|appointment|calendário|reunião|evento)\b/i,
  GOOGLEDOCS: /\b(?:google docs?|document|documento)\b/i,
  GOOGLESHEETS: /\b(?:google sheets?|spreadsheet|worksheet|folha de cálculo)\b/i,
  NOTION: /\bnotion\b/i,
  SIDEKICK_profile:
    /\b(?:profile|name|location|phone|preference|perfil|nome|localização|telefone|preferência)\b/i,
  SIDEKICK_notification: /\b(?:notification|quiet|time zone|timezone|notificação|fuso)\b/i,
  SIDEKICK_memory: /./,
};

function requestedScope(action: string, instruction: string) {
  const key = action.startsWith('SIDEKICK_')
    ? action.split('_').slice(0, 2).join('_')
    : action.split('_')[0];
  return actionScopes[key]?.test(instruction) === true;
}

function requestedInstruction(instruction: string) {
  return instruction
    .trim()
    .replace(
      /^(?:(?:please|can you|could you|would you|will you|i want you to|i'd like you to|i want to|help me|por favor|podes|pode|quero que)\s+)+/i,
      '',
    );
}

export function forbidsTransmission(action: string, instruction: string) {
  if (
    ![
      'GMAIL_SEND_EMAIL',
      'GMAIL_REPLY_TO_THREAD',
      'SLACK_SEND_MESSAGE',
      'SLACK_POST_MESSAGE',
    ].includes(action)
  )
    return false;
  const request = requestedInstruction(instruction);
  return (
    /\b(?:don't send|do not send|not send|do not publish|don't publish|não envies|não enviar)\b/i.test(
      request,
    ) ||
    /\b(?:as\s+(?:an?\s+)?(?:unsent\s+)?draft\b|(?:keep|leave|save)(?:\s+(?:it|this|that|the\s+(?:e-?mail|message|reply)))?\s+unsent\b|unsent\s*[.!]?$)/i.test(
      request,
    ) ||
    (requestedScope(action, request) && intentWords.draft.test(request))
  );
}

export function explicitlyRequestsAction(action: string, instruction: string) {
  const intents = ordinaryActions[action];
  if (
    !intents ||
    !instruction.trim() ||
    instruction.length > 12_000 ||
    !requestedScope(action, instruction)
  )
    return false;
  const request = requestedInstruction(instruction);
  if (/^(?:don't|do not|never|não)\b/i.test(request)) return false;
  if (forbidsTransmission(action, instruction)) return false;
  if (
    intents.includes('send') &&
    /^(?:send|forward|envia|manda)\s+(?:me|us|nos|me a mim)\b/i.test(request)
  )
    return false;
  return intents.some((intent) => intentWords[intent].test(request));
}

export function confirmationAnswer(text: string) {
  const value = text
    .trim()
    .replace(/[.!]+$/, '')
    .toLowerCase();
  if (
    /^(?:yes|yes please|confirm|confirmed|go ahead|do it|sim|sim por favor|confirmo|podes avançar)$/.test(
      value,
    )
  )
    return true;
  if (/^(?:no|no thanks|cancel|don't|do not|não|nao|cancela|cancelar)$/.test(value)) return false;
  return undefined;
}
