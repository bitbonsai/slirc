# ergo, built from source. Published as a manifest list for linux/arm64 and linux/amd64 by
# `just build-ergo`, which reads ERGO_VERSION and ERGO_COMMIT from here.
FROM docker.io/golang:1.27-alpine AS build-env

RUN apk add --no-cache make git ca-certificates

# Stock upstream only. ERGO_COMMIT is the full commit the ERGO_VERSION tag points to; the build
# fetches that commit, so a moved tag cannot change what gets built.
ARG ERGO_VERSION=v2.19.1
ARG ERGO_COMMIT=63c743a70644f0f19109508ade8580bf37f7d23d
RUN git init -q /ergo \
    && cd /ergo \
    && git fetch -q --depth 1 https://github.com/ergochat/ergo ${ERGO_COMMIT} \
    && git checkout -q FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${ERGO_COMMIT}" \
    && make install

FROM docker.io/alpine:3.22

COPY --from=build-env /go/bin/ergo /ircd-bin/ergo
COPY --from=build-env /ergo/distrib/docker/run.sh /ircd-bin/run.sh
COPY --from=build-env /ergo/default.yaml /ircd-bin/default.yaml
COPY --from=build-env /ergo/languages /ircd-bin/languages/
COPY --from=build-env /ergo/ergo.motd /ircd/ergo.motd

VOLUME /ircd
WORKDIR /ircd
ENTRYPOINT ["/ircd-bin/run.sh"]
