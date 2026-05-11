# Vencord GM&S Edition (with scheduledUserbot)

This is a custom fork of Vencord that includes the `scheduledUserbot` user plugin for delayed and recurring message dispatch in Discord.

## How to Use the Plugin

1. **The `/schedule` Command**
   - Type the `/schedule` command in any text channel.
   - **Important:** You must use this command as a reply to the message you want to schedule.
   - Provide the necessary parameters: time interval and number of repetitions.
   
2. **How it Works**
   - The plugin automatically reads the text and attachments from the message you replied to.
   - It will send the message in the background at the specified interval.
   - All logs regarding successful dispatches or errors will be silently sent to your Direct Messages (DMs) to avoid drawing attention and cluttering public chats.

## Installation and Build

The `scheduledUserbot` plugin is located in the `src/userplugins` directory and is automatically included when building this fork.

### 1. Install Dependencies
Make sure you have Node.js and pnpm installed. Run the following command:
```bash
pnpm install
```

### 2. Build the Project
To compile Vencord along with your plugin:
```bash
pnpm build
```

*(Alternatively, for development, you can use `pnpm watch` to apply changes on the fly. Just press `Ctrl + R` in Discord to reload)*

### 3. Install in Discord
Install Vencord into your client (using the official installer) and enable the `scheduledUserbot` plugin in the Vencord plugins settings within Discord itself.
