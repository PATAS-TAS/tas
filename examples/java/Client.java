import java.net.*;
import java.io.*;

public class Client {
    static String API_KEY = System.getenv("TAS_API_KEY") != null 
        ? System.getenv("TAS_API_KEY") : "your-api-key";
    static String BASE_URL = System.getenv("TAS_BASE_URL") != null
        ? System.getenv("TAS_BASE_URL") : "https://tas.fly.dev";

    public static String classify(String text, String lang) throws Exception {
        String json = "{\"text\":\"" + text + "\",\"lang\":\"" + lang + "\"}";
        URL url = new URL(BASE_URL + "/v1/classify");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("X-API-Key", API_KEY);
        conn.setDoOutput(true);
        
        try (OutputStream os = conn.getOutputStream()) {
            os.write(json.getBytes());
        }
        
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(conn.getInputStream()))) {
            StringBuilder response = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                response.append(line);
            }
            return response.toString();
        }
    }

    public static void main(String[] args) {
        try {
            String result = classify("Earn $1000/day working from home! Click https://scam.com", "en");
            System.out.println("Result: " + result);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}

