// The description of the API (NOTES-25 AC-25): Swagger UI from this server, never from the internet, without
// "Try it out" (requests with an Origin header are refused anyway; the examples use curl).
window.addEventListener('load', function () {
  window.SwaggerUIBundle({
    url: '/api/v1/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    supportedSubmitMethods: [],
    tryItOutEnabled: false,
    validatorUrl: null,
    defaultModelsExpandDepth: 0,
  })
})
