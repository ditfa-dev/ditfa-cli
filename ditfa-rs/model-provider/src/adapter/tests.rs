#[cfg(test)]
mod tests {
    use super::super::anthropic::AnthropicAdapter;
    use super::super::chat_completions::ChatCompletionsAdapter;
    use super::super::gemini::GeminiAdapter;
    use super::super::openai::OpenAiAdapter;
    use super::super::ProviderAdapter;
    use ditfa_api::ResponsesApiRequest;
    use ditfa_protocol::models::ContentItem;
    use ditfa_protocol::models::FunctionCallOutputPayload;
    use ditfa_protocol::models::ResponseItem;

    fn sample_request() -> ResponsesApiRequest {
        ResponsesApiRequest {
            model: "claude-sonnet-4".to_string(),
            instructions: "You are a helpful AI coding assistant.".to_string(),
            input: vec![
                ResponseItem::Message {
                    id: None,
                    role: "user".to_string(),
                    content: vec![ContentItem::InputText {
                        text: "Write a fibonacci function in Rust.".to_string(),
                    }],
                    phase: None,
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::FunctionCall {
                    id: None,
                    name: "exec_command".to_string(),
                    namespace: None,
                    arguments: r#"{"cmd":"ls -la"}"#.to_string(),
                    call_id: "call_123".to_string(),
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::FunctionCallOutput {
                    id: None,
                    call_id: "call_123".to_string(),
                    output: FunctionCallOutputPayload::String("dir contents".to_string()),
                    internal_chat_message_metadata_passthrough: None,
                },
            ],
            tools: None,
            tool_choice: "auto".to_string(),
            parallel_tool_calls: true,
            reasoning: None,
            store: false,
            stream: true,
            stream_options: None,
            include: Vec::new(),
            service_tier: None,
            prompt_cache_key: None,
            text: None,
            client_metadata: None,
        }
    }

    #[test]
    fn test_openai_adapter_capabilities() {
        let adapter = OpenAiAdapter::new("https://api.openai.com/v1".to_string());
        assert_eq!(adapter.provider_id(), "openai");
        let caps = adapter.capabilities();
        assert!(caps.function_calling);
        assert!(caps.custom_tool_calls);
        assert!(caps.web_search);
        assert!(caps.image_generation);
        assert!(caps.remote_compaction);
    }

    #[test]
    fn test_anthropic_adapter_request_translation() {
        let adapter = AnthropicAdapter::new("https://api.anthropic.com".to_string());
        assert_eq!(adapter.provider_id(), "anthropic");
        let req = sample_request();
        let payload = adapter.translate_request(&req);

        assert_eq!(payload["model"], "claude-sonnet-4");
        assert_eq!(payload["system"], "You are a helpful AI coding assistant.");
        
        let messages = payload["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "Write a fibonacci function in Rust.");
        assert_eq!(messages[1]["content"][0]["type"], "tool_use");
        assert_eq!(messages[1]["content"][0]["name"], "exec_command");
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn test_gemini_adapter_request_translation() {
        let adapter = GeminiAdapter::new("https://generativelanguage.googleapis.com".to_string());
        assert_eq!(adapter.provider_id(), "gemini");
        let req = sample_request();
        let payload = adapter.translate_request(&req);

        assert_eq!(
            payload["systemInstruction"]["parts"][0]["text"],
            "You are a helpful AI coding assistant."
        );
        let contents = payload["contents"].as_array().expect("contents array");
        assert!(!contents.is_empty());
        assert_eq!(contents[0]["role"], "user");
    }

    #[test]
    fn test_chat_completions_adapter_request_translation() {
        let adapter = ChatCompletionsAdapter::new("http://localhost:8000/v1".to_string());
        assert_eq!(adapter.provider_id(), "chat-completions");
        let req = sample_request();
        let payload = adapter.translate_request(&req);

        let messages = payload["messages"].as_array().expect("messages array");
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "You are a helpful AI coding assistant.");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["tool_calls"][0]["type"], "function");
    }
}
