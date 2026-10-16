export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'ERROR',
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'BAD_REQUEST') => new HttpError(400, msg, code);
export const unauthorized = (msg = 'No autenticado') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Sin permisos para esta acción') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Recurso no encontrado') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg: string, code = 'CONFLICT') => new HttpError(409, msg, code);
