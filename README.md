# Notion CMS

This project provides seamless integration between Notion's collaborative editing capabilities and your blog's frontend, allowing you to write, manage, and publish content directly from Notion.

## Features

- **Notion Database Integration**: Connect directly to your Notion database to manage blog posts
- **Content Synchronization**: Automatically sync content from Notion to your blog
- **Rich Content Support**: Handle rich text, images, embeds, and other Notion block types
- **Flexible Architecture**: Modular design allows easy integration with various frontend frameworks
- **Type Safety**: Built with TypeScript for robust development experience

## Environment Variables

### For blogFetchWorker

Before running the project, you'll need to set up the following environment variables. Create a `.env` file in the root directory and add these variables:

```env
- NOTION_API_KEY=your_notion_integration_token
- NOTION_DATABASE_ID=your_database_id
- MEDIA_SECRET_KEY=secret_used_to_verify_upload
```

# Add additional environment variables here as the project grows
```

### For mediaWorker

```env
- MEDIA_SECRET_KEY=secret_used_to_verify_upload
- R2_PUBLIC_URL=base_url_to_access_files
```

## Installation

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd notion-cms
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up environment variables:

   - Copy `.env.example` to `.env` (if available)
   - Or create a new `.env` file with the variables listed above
   - Fill in your Notion credentials

4. Run the development server:
   ```bash
   npm run dev
   ```

## Usage

_Usage instructions will be added as the project develops_

## Contributing

_Contributing guidelines will be added as the project grows_

## License

_License information will be added_
