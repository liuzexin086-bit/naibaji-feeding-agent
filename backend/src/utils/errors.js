class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status || 500
    this.details = details || null
  }
}

function badRequest(message, details) {
  return new HttpError(400, message, details)
}

function notFound(message) {
  return new HttpError(404, message || 'Not found')
}

function toErrorResponse(error) {
  return {
    error: {
      message: error.message || 'Internal server error',
      details: error.details || null,
    },
  }
}

module.exports = { HttpError, badRequest, notFound, toErrorResponse }
