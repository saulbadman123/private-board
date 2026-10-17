export class HttpError extends Error {
  status:number;code:string;retryAfter?:number;
  constructor(status:number,code:string,message:string,retryAfter?:number){super(message);this.status=status;this.code=code;this.retryAfter=retryAfter;}
}
