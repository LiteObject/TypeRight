# TypeRight

**TypeRight** is a Chrome extension that provides real-time, AI-powered grammar checking as you type. It monitors text input fields across web pages and automatically offers natural, grammatically correct alternatives.

## Features

- **Real-time Grammar Checking** - Automatically checks your text after you stop typing
- **AI-Powered** - Uses Ollama with local LLM models for intelligent suggestions
- **Natural Suggestions** - Offers more natural and clear alternatives
- **Multiple Input Support** - Works with text inputs, textareas, and contenteditable elements
- **Beautiful UI** - Clean side panel interface for viewing suggestions
- **Privacy-Focused** - All processing happens locally on your machine

## Prerequisites

Before using TypeRight, you need to have Ollama installed and running on your machine.

### Install Ollama

1. **Download and install Ollama:**
   - Visit [https://ollama.ai](https://ollama.ai)
   - Download the installer for your operating system
   - Follow the installation instructions

2. **Pull a language model:**
   ```bash
   ollama pull llama3.2
   ```
   - **Live Status Indicator** - See when TypeRight is working via the panel status messages
   - **Panel-Controlled Checks** - Grammar checking only runs while the side panel is open
   ollama pull mistral
   ```

3. **Start Ollama server:**
   ```bash
   ollama serve
   ```
   
   The server should now be running on `http://localhost:11434`
   3. **Open the TypeRight side panel** by clicking the TypeRight icon (or via Chrome's side panel menu). Keep it open to allow checks.

   4. **Start typing** in any text field

   5. **Pause for about 2 seconds** after you stop typing. You'll see "Checking with Ollama…" in the panel while the request runs.

   6. **Review suggestions** in the side panel (it stays open between checks)

   7. **Copy or dismiss** suggestions:

1. **Clone or download this repository**
   ```bash
   git clone https://github.com/LiteObject/TypeRight.git
   cd TypeRight
   ```

2. **Open Chrome Extensions page**
      typingDelay: 2000, // Time in milliseconds (2000 = 2 seconds)
   - Or click the menu icon (⋮) → More tools → Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top right corner

4. **Load the extension**
   - Click "Load unpacked"
   - Select the `TypeRight` folder
   - The extension should now appear in your extensions list

5. **Pin the extension** (optional)
   - Click the extensions icon (puzzle piece) in the toolbar
   - Click the pin icon next to TypeRight

## Usage

1. **Make sure Ollama is running:**
   ```bash
   ollama serve
   ```

2. **Navigate to any webpage** with text input fields (e.g., Gmail, Twitter, Google Docs)

3. **Start typing** in any text field

4. **Wait 1.5 seconds** after you stop typing - TypeRight will automatically check your text

5. **Review suggestions** in the side panel that opens automatically

6. **Copy or dismiss** suggestions:
   - Use the copy icons next to "Revised" or "Alternative" to copy the text
   - Click "Dismiss" to remove the suggestion card from the list

   4. Confirm the TypeRight side panel is open; checks won't run while it's closed
## Configuration

### Change AI Model

Edit `background.js` and modify the `CONFIG.model` value:

```javascript
const CONFIG = {
  aiServiceUrl: 'http://localhost:11434/api/chat',
  model: 'llama3.2', // Change this to your preferred model
  maxRetries: 2,
  requestTimeout: 30000,
};
```

Available models (after pulling with Ollama):
- `llama3.2` (recommended, latest)
- `llama3.1`
- `mistral`
- `phi3`
- Other models from [Ollama Library](https://ollama.ai/library)

### Adjust Typing Delay

Edit `content.js` and modify the `CONFIG.typingDelay` value:

```javascript
const CONFIG = {
  typingDelay: 1500, // Time in milliseconds (1500 = 1.5 seconds)
  minTextLength: 10,
  debounceDelay: 300,
};
```

### Change Minimum Text Length

Edit `content.js` and modify the `CONFIG.minTextLength` value:

```javascript
const CONFIG = {
  typingDelay: 1500,
  minTextLength: 10, // Minimum characters before checking
  debounceDelay: 300,
};
```

## Supported Websites

TypeRight works on virtually any website with text input fields, including:

- Gmail / Google Workspace
- Twitter / X
- Facebook
- LinkedIn
- Reddit
- Slack (web version)
- Discord (web version)
- GitHub
- Notion
- And many more!

## Architecture

```
┌─────────────────┐
│   Web Page      │
│  (Text Input)   │
└────────┬────────┘
         │ User types
         ▼
┌─────────────────┐
│  content.js     │
│  - Monitors     │
│  - Detects      │
│  - Debounces    │
└────────┬────────┘
         │ After 1.5s
         ▼
┌─────────────────┐
│ background.js   │
│  - Coordinates  │
│  - API calls    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Ollama API     │
│  (localhost)    │
│  - llama3.2     │
└────────┬────────┘
         │ Grammar check
         ▼
┌─────────────────┐
│  sidepanel.js   │
│  - Displays     │
│  - Allows copy  │
└─────────────────┘
```

## Troubleshooting

### Quick Debug Steps

1. **Reload the extension after any changes:**
   - Go to `chrome://extensions/`
   - Click the reload icon (↻) on TypeRight

2. **Check if Ollama is running:**
   ```bash
   curl http://localhost:11434/api/tags
   ```
   Should return a list of available models.

3. **Check Chrome console:**
   - Right-click on the page → Inspect
   - Go to Console tab
   - Look for "TypeRight" messages

4. **Check extension console:**
   - Go to `chrome://extensions/`
   - Find TypeRight
   - Click "Inspect views: service worker"
   - Check for errors and "TypeRight: Ollama raw response" messages

### Grammar checks not triggering

1. Make sure you're typing in a supported element (input, textarea, contenteditable)
2. Wait at least 1.5 seconds after stopping typing
3. Ensure text is at least 10 characters long

### Suggestions not appearing

1. Check if the side panel opens automatically
2. Try clicking the TypeRight icon in the toolbar to manually open the side panel
3. Check the extension console for errors

### Ollama connection issues

1. Verify Ollama is running: `ollama serve`
2. Check if the model is pulled: `ollama list`
3. Test the API directly:
   ```bash
   curl http://localhost:11434/api/chat -d '{
     "model": "llama3.2",
     "messages": [{"role": "user", "content": "Hello"}],
     "stream": false
   }'
   ```

## Privacy & Security

- All text processing happens **locally** on your machine
- No data is sent to external servers
- Uses your own Ollama instance
- Open source - audit the code yourself
- No tracking or analytics

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Ollama](https://ollama.ai) for local LLM inference
- Inspired by the need for privacy-focused grammar checking tools
- Uses Chrome's Manifest V3 for modern extension development

## Support

If you encounter any issues or have questions:

1. Check the [Troubleshooting](#troubleshooting) section
2. Open an issue on [GitHub](https://github.com/LiteObject/TypeRight/issues)
3. Make sure Ollama is properly installed and running

---

**Made by [LiteObject](https://github.com/LiteObject)**
