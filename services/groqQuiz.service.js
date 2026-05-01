import axios from 'axios';

export const askQuizAi = async (messages, options = {}) => {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array is empty.');
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is missing in environment variables.');
  }

  const model = options.model || process.env.GROQ_QUIZ_MODEL || 'openai/gpt-oss-120b';
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : null;
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
  const topP = typeof options.topP === 'number' ? options.topP : 0.85;
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : null;
  const reasoningEffort = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : '';
  const usageTag = options.usageTag || 'quiz-generation';

  const timeoutPart = timeoutMs ? ` timeoutMs=${timeoutMs}` : '';
  const maxTokensPart = maxTokens ? ` max_tokens=${maxTokens}` : '';
  const reasoningPart = reasoningEffort ? ` reasoning_effort=${reasoningEffort}` : '';
  console.log(
    `[AI][${usageTag}] model=${model}${timeoutPart} temperature=${temperature} top_p=${topP}${maxTokensPart}${reasoningPart}`
  );

  try {
    const requestBody = {
      model,
      messages,
      temperature,
      top_p: topP
    };

    if (maxTokens) {
      requestBody.max_tokens = maxTokens;
    }
    if (reasoningEffort) {
      requestBody.reasoning_effort = reasoningEffort;
    }

    const requestConfig = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };

    if (timeoutMs) {
      requestConfig.timeout = timeoutMs;
    }

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      requestBody,
      requestConfig
    );

    const rawContent = response?.data?.choices?.[0]?.message?.content;
    const content =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((item) => {
                if (typeof item === 'string') return item;
                return typeof item?.text === 'string' ? item.text : '';
              })
              .join('')
          : '';
    const finishReason = response?.data?.choices?.[0]?.finish_reason || 'unknown';
    const usage = response?.data?.usage || {};
    console.log(
      `[AI][${usageTag}] response status=${response?.status || 200} finish_reason=${finishReason} prompt_tokens=${
        usage.prompt_tokens ?? 'n/a'
      } completion_tokens=${usage.completion_tokens ?? 'n/a'} total_tokens=${usage.total_tokens ?? 'n/a'}`
    );

    if (!content || !content.trim()) {
      console.error(
        `[AI][${usageTag}] empty content returned`,
        JSON.stringify(
          {
            status: response?.status || 200,
            finishReason,
            usage,
            choiceCount: Array.isArray(response?.data?.choices) ? response.data.choices.length : 0
          },
          null,
          2
        )
      );
      throw new Error('AI returned empty response.');
    }

    if (options.returnMeta === true) {
      return {
        content,
        usage: response?.data?.usage || {},
        modelUsed: model
      };
    }

    return content;
  } catch (error) {
    const providerError = error?.response?.data?.error?.message || error?.response?.data || error?.message;
    const status = error?.response?.status || 'unknown';
    const errorPayload = error?.response?.data || null;
    console.error(
      `[AI][${usageTag}] request failed model=${model} status=${status}`,
      JSON.stringify(
        {
          providerError,
          errorPayload,
          timeoutMs,
          temperature,
          topP,
          maxTokens,
          reasoningEffort,
          messageCount: messages.length
        },
        null,
        2
      )
    );
    throw new Error(`Groq Quiz API Error: ${providerError}`);
  }
};
