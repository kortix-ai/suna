# Veo 3 Video Generation Setup Guide

## Overview
This guide explains how to set up Google Veo 3 video generation in your Kusor system.

## Prerequisites

### 1. Google Cloud Account
- Create a Google Cloud account at https://cloud.google.com/
- Enable billing on your account
- Create a new project or use an existing one

### 2. Enable Required APIs
Enable the following APIs in your Google Cloud project:
```bash
# Enable Vertex AI API
gcloud services enable aiplatform.googleapis.com

# Enable Video Intelligence API (if needed)
gcloud services enable videointelligence.googleapis.com
```

### 3. Authentication Setup

#### Option A: Service Account (Recommended for Production)
```bash
# Create a service account
gcloud iam service-accounts create kusor-veo3 \
    --display-name="Kusor Veo 3 Service Account"

# Grant necessary permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:kusor-veo3@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user"

# Create and download the key
gcloud iam service-accounts keys create kusor-veo3-key.json \
    --iam-account=kusor-veo3@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

#### Option B: Application Default Credentials (For Development)
```bash
# Authenticate with your Google account
gcloud auth application-default login
```

## Environment Variables

Add the following environment variables to your `.env` file:

```bash
# Google Cloud Configuration
GOOGLE_APPLICATION_CREDENTIALS=/path/to/kusor-veo3-key.json
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GOOGLE_CLOUD_REGION=us-central1

# Alternative: If using GEMINI_API_KEY for Veo 3
GEMINI_API_KEY=your-gemini-api-key
```

## Installation

### 1. Install Dependencies
The required dependencies are already added to `pyproject.toml`:
- `google-cloud-aiplatform>=1.38.0`
- `litellm==1.75.2` (for unified API access)

### 2. Update Your Environment
```bash
# Rebuild the backend container
docker build -t kusorregistry.azurecr.io/kusor-backend:latest .

# Push to registry
docker push kusorregistry.azurecr.io/kusor-backend:latest

# Update Azure container
az containerapp update --name kusor-backend --resource-group kusor-rg --image kusorregistry.azurecr.io/kusor-backend:latest
```

## Usage

### Basic Video Generation
```python
# Generate a simple video
result = await video_tool.generate_video(
    prompt="A beautiful sunset over mountains with birds flying across the sky",
    duration=10,
    style="cinematic",
    aspect_ratio="16:9",
    include_audio=True
)
```

### Image-to-Video Generation
```python
# Generate video from an existing image
result = await video_tool.generate_video_from_image(
    image_url="https://example.com/image.jpg",
    prompt="The clouds drift slowly while the colors gradually change",
    duration=8,
    motion_intensity="subtle"
)
```

## Model Options

### Veo 3 Models Available:
- **veo-3-generate-001**: Standard Veo 3 model
- **veo-3-fast-generate-001**: Faster generation for rapid iteration

### LiteLLM Integration:
```python
# Using LiteLLM (if supported)
response = await acompletion(
    model="google/veo-3-generate-001",
    messages=[{"role": "user", "content": "Generate a video: {prompt}"}],
    extra_body={
        "video_generation": True,
        "duration": duration,
        "style": style
    }
)
```

## Pricing

### Veo 3 Pricing (as of 2024):
- **Veo 3**: ~$0.30 per 10-second video
- **Veo 3 Fast**: ~$0.15 per 10-second video

### Cost Optimization Tips:
1. Use Veo 3 Fast for prototyping
2. Use standard Veo 3 for final production videos
3. Set reasonable duration limits (default: 5 seconds)
4. Monitor usage through Google Cloud Console

## Troubleshooting

### Common Issues:

1. **Authentication Errors**
   - Verify `GOOGLE_APPLICATION_CREDENTIALS` path
   - Check service account permissions
   - Ensure project ID is correct

2. **API Not Enabled**
   - Enable Vertex AI API in Google Cloud Console
   - Check billing is enabled

3. **Model Not Found**
   - Verify model name: `google/veo-3-generate-001`
   - Check if Veo 3 is available in your region

4. **LiteLLM Issues**
   - Update LiteLLM to latest version
   - Check if Veo 3 support is available
   - Use direct Vertex AI API as fallback

### Debug Mode:
```python
# Enable debug logging
import logging
logging.getLogger("google.cloud.aiplatform").setLevel(logging.DEBUG)
```

## Security Considerations

1. **Credential Management**
   - Store service account keys securely
   - Use Azure Key Vault for production
   - Rotate keys regularly

2. **Content Filtering**
   - Implement content policy checks
   - Monitor generated content
   - Set appropriate usage limits

3. **Rate Limiting**
   - Implement request throttling
   - Monitor API quotas
   - Set user limits

## Next Steps

1. Test the integration with a simple video generation
2. Implement content moderation
3. Add user usage tracking
4. Set up monitoring and alerts
5. Optimize for cost and performance

## Support

- Google Cloud Documentation: https://cloud.google.com/vertex-ai/generative-ai/docs/models/veo
- LiteLLM Documentation: https://docs.litellm.ai/
- Kusor Issues: Create an issue in the repository
