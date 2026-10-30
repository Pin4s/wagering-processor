import { Injectable, type CanActivate } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    // Ponto de extensão para um IdP externo, como Keycloak ou Zitadel via OIDC.
    // A integração deverá validar o JWT e mapear o client do provedor para providerId.
    return true;
  }
}
