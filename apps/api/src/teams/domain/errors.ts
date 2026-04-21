export class TeamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotAuthorizedError extends TeamsError {
  readonly httpStatus = 403;
}

export class NotFoundError extends TeamsError {
  readonly httpStatus = 404;
}

export class AlreadyMemberError extends TeamsError {
  readonly httpStatus = 409;
}

export class AlreadyAcceptedError extends TeamsError {
  readonly httpStatus = 409;
}

export class InviteExpiredError extends TeamsError {
  readonly httpStatus = 410;
}

export class WrongEmailError extends TeamsError {
  readonly httpStatus = 403;
}

export class ValidationError extends TeamsError {
  readonly httpStatus = 400;
}
