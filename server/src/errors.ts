export class ApiError extends Error {
  status: number;
  code: string;
  field: string | undefined;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
