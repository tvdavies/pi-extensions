import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

const sendUserMessageSchema = Type.Object({
	message: Type.String({
		description:
			"A very brief progress note for the user. Keep it to one or two short sentences.",
	}),
});

export type SendUserMessageInput = Static<typeof sendUserMessageSchema>;

function textFromResult(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.find((part) => part.type === "text")?.text?.trim() ?? "";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "send_user_message",
		label: "send user message",
		description:
			"Show the user a brief natural-language progress note about what you are doing. Use sparingly; one or two short sentences max.",
		renderShell: "self",
		promptSnippet: "Show the user a brief progress note",
		promptGuidelines: [
			"Use send_user_message only for brief progress annotations that help the user follow what you are doing.",
			"When using send_user_message, keep the message to one or two short sentences maximum.",
		],
		parameters: sendUserMessageSchema,

		async execute(_toolCallId, params, _signal, onUpdate) {
			const message = params.message.trim();

			const details = { renderedAsAssistantMessage: true };

			// Emit an update so the note can appear while the tool is still running.
			onUpdate?.({ content: [{ type: "text", text: message }], details });

			return {
				content: [{ type: "text", text: message }],
				details,
			};
		},

		renderCall(_args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 1, 0);
			// Hide the tool-call chrome; renderResult shows the note itself.
			text.setText("");
			return text;
		},

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 1, 0);
			const message = textFromResult(result);
			text.setText(message ? theme.fg("text", message) : "");
			return text;
		},
	});
}
