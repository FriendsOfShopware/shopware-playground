<?php declare(strict_types=1);

namespace Shopware\Core\Maintenance\System\Service;

use Shopware\Core\Framework\Log\Package;

/**
 * Playground override (Shopware 6.6): openssl_pkey_new() is not available in
 * PHP WASM, and these RSA JWT keys are deprecated anyway (6.7 uses HMAC).
 * Ships a static, publicly known playground keypair instead.
 *
 * @internal
 */
#[Package('framework')]
class JwtCertificateGenerator
{
    private const PRIVATE_KEY = <<<'PEM'
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7pk0uzlNg2hgt
PTIJ7S7KhbT1sU2T97K18gTjlKEfBlPTKX8v6B+sNmNOuxZsDaULYI2RXxA/HNsT
P04EZ6rDqNKjwIdEbDpos8N9qcyiivfv1nocUYS5y3f8ejjKITDds2EIpRpxc2nP
PsVN4ZEHIYcym71gFOCgp2iVuhcuLZQJ426GSnycKsdXAX328pElKf/TM9NE521i
u3RlPFfVqCcbmo/kaBiYwYUZe57ZVNGAm5wmjYTKsMIc1zo91BrWKFX12Nf/+EU3
kgHtkAxyxivpRFJoasBOj/NmTuyV/f7+h/aWY1mD3YI3RCw+HdyDWC6iX/16ZcmL
4ahlz761AgMBAAECggEABRHj2UqPIM7DrcqOz4suTcp5rn8GhDjtBdLEJGH0+Hbz
TNaSLnksYeVrnspEkNF4OWvNEgsUz/UM9jgqTh7UPkpmu9s3zGF1h96o1CcCSwyg
0O9lMolWogPH+h+ok818byupiNJCefjkTZ/PNODN9Piy7mscHWcdqo7bWdrtRWdp
5NFonLMNUphrq3n7ibAAzIRMe0lvs9iBaZCphvO6GISIfSbTup1OSLD+g8DEjMfU
qsEAL461mN6Zx53gttHAO0VsIRXUl+ck6zEHplJlmFmw4ZomFmthEQWmijpZtDW5
W7vC802YWmGeOihdVe7iez4Bi/jn2ZfbdSIlm1ULAQKBgQD66UIFXbJdR9htoLsn
opI7MLSCmE40QZegs/BalKCUBtFaG5rbfTHy7BPVJkIsrxVf0UgT0hW7wht4QUT6
ea+LPcOkE3WOsecS5lRKnn/asE8XZqLWQ4zcS29J6+RMM5jadRU25G44Q63ah6dw
YifhW4EMsygkFFMnUs1V+ZbYXwKBgQC/dJY3T8Z7CwJokfzXV1WRD3sgwoX1xHAy
KqNUFmct/U1m+Shx4aoQwl+Jewn7AFyJNv0hse3Jet4oksDaEzVGxddJnj/EPC1q
RNCVFt0fPfEecZ1J8P33Cd4GzAXRK7sVrPLwaKAq5IcVymsSd37J4l9OwcFSGQG1
72bRPrsRawKBgH+a9XqpJjcOfOF0JvqHUXtMz+DC+LLW0PhnyssmX2wo83uyIlWS
HD8BFS0H4gu7l1E9rDx4UZlFpJbKCvyfuklERiVByD2j+HLCNQgmB7v+gprSFeqG
PDMlIhokH90pOImRlhJupidzNA25g8xB/yo7USxWSQngVFHhaJBa+P5dAoGBAKZ/
m4tqoy+qOWP7YalcWBuZHPk2cg1z0iauke+0s/J40PF2SUgQejes8iy7hch1XgQu
gCDnfeW0JrOePHzqK3Dq6Pkq2EWuF8jNI6AkjBR5Z9GT+LevDw3h1OaQU5a+syp8
h6GvO2tR5nB64nbi2K51YXE6awccnDI+imn6ZfEVAoGAV0riC7AJ+tFQZ1Xg0Vbk
FitCShlNGRCAm6flo5vOk3AwfTTppwk7FjtIKHOXtUshbRGKiLDo0gJ+Mshew3La
zmJUd28EbeQ304fimVzbIFZGxTbPihUpUdd8Pyh+bcvchV9eXmg3cxok1RRP2Y2t
xL5ct9cYwXWO6lz4JUKJQTw=
-----END PRIVATE KEY-----
PEM;

    private const PUBLIC_KEY = <<<'PEM'
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu6ZNLs5TYNoYLT0yCe0u
yoW09bFNk/eytfIE45ShHwZT0yl/L+gfrDZjTrsWbA2lC2CNkV8QPxzbEz9OBGeq
w6jSo8CHRGw6aLPDfanMoor379Z6HFGEuct3/Ho4yiEw3bNhCKUacXNpzz7FTeGR
ByGHMpu9YBTgoKdolboXLi2UCeNuhkp8nCrHVwF99vKRJSn/0zPTROdtYrt0ZTxX
1agnG5qP5GgYmMGFGXue2VTRgJucJo2EyrDCHNc6PdQa1ihV9djX//hFN5IB7ZAM
csYr6URSaGrATo/zZk7slf3+/of2lmNZg92CN0QsPh3cg1guol/9emXJi+GoZc++
tQIDAQAB
-----END PUBLIC KEY-----
PEM;

    /**
     * @return array{0: string, 1: string}
     */
    public function generateString(?string $passphrase = null): array
    {
        return [self::PRIVATE_KEY, self::PUBLIC_KEY];
    }

    public function generate(string $privateKeyPath, string $publicKeyPath, ?string $passphrase = null): void
    {
        $privateKeyDirectory = \dirname($privateKeyPath);
        if (!\is_dir($privateKeyDirectory)) {
            \mkdir($privateKeyDirectory, 0755, true);
        }
        $publicKeyDirectory = \dirname($publicKeyPath);
        if (!\is_dir($publicKeyDirectory)) {
            \mkdir($publicKeyDirectory, 0755, true);
        }
        \file_put_contents($privateKeyPath, self::PRIVATE_KEY);
        \file_put_contents($publicKeyPath, self::PUBLIC_KEY);
    }
}
