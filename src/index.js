export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method === "GET") {
        return handleVerification(url, env);
      }
      if (request.method === "POST") {
        return handleWebhook(request, env, ctx);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

function handleVerification(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

async function handleWebhook(request, env, ctx) {
  const body = await request.json();

  if (body.object !== "instagram") {
    return new Response("OK", { status: 200 });
  }

  const commentEvents = extractCommentEvents(body);

  if (commentEvents.length > 0) {
    ctx.waitUntil(processComments(commentEvents, env));
  }

  return new Response("OK", { status: 200 });
}

function extractCommentEvents(body) {
  const events = [];

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === "comments") {
        events.push({
          commentId: change.value.id,
          commentText: change.value.text,
          mediaId: change.value.media?.id,
          fromUsername: change.value.from?.username,
          fromId: change.value.from?.id,
          igUserId: entry.id,
        });
      }
    }
  }

  return events;
}

async function processComments(events, env) {
  for (const event of events) {
    try {
      // Ignora comentários do próprio perfil
      if (event.fromId === event.igUserId) {
        console.log(`Ignoring own comment from ${event.fromUsername}`);
        continue;
      }

      const media = await fetchMediaDetails(event.mediaId, env);
      const reply = await generateReply(media, event, env);
      await postReply(event.commentId, reply, env);

      console.log(`Replied to comment ${event.commentId} from @${event.fromUsername}`);
    } catch (err) {
      console.error(`Error processing comment ${event.commentId}:`, err);
    }
  }
}

async function fetchMediaDetails(mediaId, env) {
  const url = `${env.INSTAGRAM_GRAPH_API_URL}/${mediaId}?fields=caption,media_type,media_url,permalink&access_token=${env.INSTAGRAM_ACCESS_TOKEN}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Instagram API error fetching media: ${error}`);
  }

  return response.json();
}

async function generateReply(media, event, env) {
  const prompt = `Você é o assistente de redes sociais da marca Mapa de Cores. Gere uma resposta curta e simpática para o seguinte comentário no Instagram.

Publicação: "${media.caption || "(sem legenda)"}"
Comentário de @${event.fromUsername}: "${event.commentText}"

Regras:
- Responda em português do Brasil
- Seja simpático e engajador
- Máximo 200 caracteres
- Não use hashtags na resposta
- Responda apenas com o texto da resposta, sem aspas`;

  const response = await fetch(`${env.GEMINI_API_URL}?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 128,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${error}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text.trim();
}

async function postReply(commentId, message, env) {
  const url = `${env.INSTAGRAM_GRAPH_API_URL}/${commentId}/replies`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      access_token: env.INSTAGRAM_ACCESS_TOKEN,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Instagram API error posting reply: ${error}`);
  }

  return response.json();
}
