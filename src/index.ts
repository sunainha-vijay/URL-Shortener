import { Hono, Context, Next } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { nanoid } from 'nanoid'

type Env = {
  URL_MAPPINGS: KVNamespace
  URL_ANALYTICS: KVNamespace
  API_KEYS: KVNamespace
  REDIRECT_URL: string
}

const app = new Hono<{ Bindings: Env }>()

// Middleware for API key authentication
const apiKeyAuth = async (c: Context, next: Next) => {
  const apiKey = c.req.header('X-API-Key') || c.req.query('api_key')
  if (!apiKey) {
    return c.json({ error: 'API key is missing' }, 401)
  }
  const storedApiKey = await c.env.API_KEYS.get(apiKey)
  if (!storedApiKey) {
    return c.json({ error: 'Invalid API key' }, 401)
  }
  await next()
}

// Middleware for rate limiting
const rateLimiter = async (c: Context, next: Next) => {
  const ip = c.req.header('CF-Connecting-IP')
  const rateLimitKey = `rate_limit:${ip}`
  const limit = 100
  const window = 60

  let count = await c.env.URL_ANALYTICS.get(rateLimitKey)
  count = count ? parseInt(count) : 0

  if (count >= limit) {
    return c.json({ error: 'Too many requests' }, 429)
  }

  await c.env.URL_ANALYTICS.put(rateLimitKey, (count + 1).toString(), {
    expirationTtl: window,
  })

  await next()
}

// Schema for URL creation request
const createUrlSchema = z.object({
  url: z.string().url(),
  customCode: z.string().optional(),
  expiresIn: z.number().optional(),
})

// Generate a short code for a URL
const generateShortCode = () => nanoid(8)

// Create a new short URL
app.post(
  '/api/urls',
  apiKeyAuth,
  rateLimiter,
  zValidator('json', createUrlSchema),
  async (c) => {
    const { url, customCode, expiresIn } = c.req.valid('json')

    // Check if the URL already exists in the KV store
    console.log('Checking if URL already exists...')
    const { keys } = await c.env.URL_MAPPINGS.list()
    const existingShortCode = await Promise.all(
      keys.map(async (key) => {
        const value = await c.env.URL_MAPPINGS.get(key.name)
        if (value) {
          try {
            const { url: storedUrl } = JSON.parse(value)
            return storedUrl === url ? key.name : null
          } catch (error) {
            console.error('Error parsing JSON value:', error)
            // Skip this entry and continue with the next one
            return null
          }
        }
        return null
      })
    ).then((results) => results.find((result) => result !== null))

    if (existingShortCode) {
      const shortUrl = `https://${c.req.header('host')}/${existingShortCode}`
      return c.json({ shortUrl, url }, 200)
    }

    // Check if the custom code is provided and unique
    if (customCode) {
      const existingUrl = await c.env.URL_MAPPINGS.get(customCode)
      if (existingUrl) {
        return c.json({ error: 'Custom code already exists' }, 409)
      }
    }

    const shortCode = customCode || generateShortCode()
    const expirationDate = expiresIn ? Date.now() + expiresIn * 1000 : null

    await c.env.URL_MAPPINGS.put(
      shortCode,
      JSON.stringify({ url, expirationDate })
    )

    const shortUrl = `https://${c.req.header('host')}/${shortCode}`
    return c.json({ shortUrl, url }, 201)
  }
)

// Redirect the main domain to another domain
app.get('/', (c) => {
  const redirectUrl = c.env.REDIRECT_URL
  return c.redirect(redirectUrl)
})

// Redirect to the original URL
app.get('/:shortCode', async (c) => {
  const shortCode = c.req.param('shortCode')
  const urlData = await c.env.URL_MAPPINGS.get(shortCode)

  if (!urlData) {
    return c.notFound()
  }

  try {
    const { url, expirationDate } = JSON.parse(urlData)

    if (expirationDate && Date.now() > expirationDate) {
      await c.env.URL_MAPPINGS.delete(shortCode)
      return c.notFound()
    }

    // Increment click count
    const clickCount = await c.env.URL_ANALYTICS.get(shortCode)
    await c.env.URL_ANALYTICS.put(
      shortCode,
      (parseInt(clickCount || '0') + 1).toString()
    )

    return c.redirect(url)
  } catch (error) {
    console.error('Error parsing JSON value:', error)
    return c.notFound()
  }
})

// Get URL analytics
app.get('/api/analytics/:shortCode', apiKeyAuth, async (c) => {
  const shortCode = c.req.param('shortCode')
  const clickCount = await c.env.URL_ANALYTICS.get(shortCode)
  return c.json({ shortCode, clickCount: clickCount ? parseInt(clickCount) : 0 })
})

export default app