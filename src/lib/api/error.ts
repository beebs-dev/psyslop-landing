export class ApiError extends Error {
	status: number;
	bodyText?: string;

	constructor(message: string, status: number, bodyText?: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.bodyText = bodyText;
	}
}
