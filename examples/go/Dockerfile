FROM golang:1.21-alpine
WORKDIR /app
COPY client.go .
RUN go build -o client client.go
CMD ["./client"]

