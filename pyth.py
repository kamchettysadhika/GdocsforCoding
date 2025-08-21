import random

def predict_google_stock():
    last_price = 140.25  # pretend yesterday's closing price
    change = random.uniform(-5, 5)  # random daily move between -$5 and +$5
    predicted_price = last_price + change
    return last_price, predicted_price

if __name__ == "__main__":
    last, pred = predict_google_stock()
    print(f"Yesterday's price: ${last:.2f}")
    print(f"Predicted next price: ${pred:.2f}")
