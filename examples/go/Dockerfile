FROM golang:1.26-alpine
WORKDIR /app
COPY client.go .
RUN go build -o client client.go
CMD ["./client"]

