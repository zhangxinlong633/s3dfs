#include "s3.h"

#include <stdio.h>
#include <string.h>

static void build(http_in_t *in, char *hdrs, size_t cap, const char *signature)
{
    memset(in, 0, sizeof(*in));
    snprintf(in->method, sizeof(in->method), "GET");
    snprintf(in->path, sizeof(in->path), "/logs/a.txt");
    snprintf(hdrs, cap,
             "host: 127.0.0.1:9000\r\n"
             "x-amz-date: 20261120T120000Z\r\n"
             "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\r\n"
             "authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261120/us-east-1/s3/aws4_request, "
             "SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=%s\r\n",
             signature);
    in->hdr_block = hdrs;
    in->hdr_len = strlen(hdrs);
}

int main(int argc, char **argv)
{
    char hdrs[1024];
    http_in_t in;
    build(&in, hdrs, sizeof(hdrs), "00");
    char hex[65];
    if (s3_sigv4_sign(&in, "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20261120T120000Z",
                      "20261120/us-east-1/s3/aws4_request", hex) != 0) {
        fprintf(stderr, "sign failed\n");
        return 1;
    }
    if (argc > 1 && strcmp(argv[1], "sign") == 0) {
        fputs(hex, stdout);
        return 0;
    }
    build(&in, hdrs, sizeof(hdrs), hex);
    s3_set_credentials("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
    int status = 0;
    const char *code = NULL;
    const char *message = NULL;
    if (s3_sigv4_verify(&in, 1795176000000LL, &status, &code, &message) != 0) {
        fprintf(stderr, "expected accept, got %d %s\n", status, code ? code : "");
        return 1;
    }
    hex[63] = hex[63] == '0' ? '1' : '0';
    build(&in, hdrs, sizeof(hdrs), hex);
    if (s3_sigv4_verify(&in, 1795176000000LL, &status, &code, &message) == 0) {
        fprintf(stderr, "expected reject\n");
        return 1;
    }
    printf("ok\n");
    return 0;
}
